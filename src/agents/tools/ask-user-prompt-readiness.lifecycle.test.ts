import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createAskUserTool,
  normalizeAskUserParams,
  reserveAskUserPromptDelivery,
  waitForAskUserPromptReady,
} from "./ask-user-tool.js";
import { resetPendingAskUserQuestionsForTest } from "./ask-user-tool.test-support.js";

const validArgs = {
  questions: [
    {
      id: "deploy_target",
      header: "Deployment target",
      question: "Where should this deploy?",
      options: [{ label: "Staging" }, { label: "Production" }],
    },
  ],
};

type GatewayCall = NonNullable<Parameters<typeof createAskUserTool>[0]["gatewayCall"]>;

afterEach(() => {
  resetPendingAskUserQuestionsForTest();
});

describe("ask_user prompt readiness lifecycle", () => {
  it("releases a reservation when readiness expires before execution starts", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    try {
      const questions = normalizeAskUserParams(validArgs).questions;
      const sessionKey = "agent:main:readiness-expired-cleanup";
      const reservation = reserveAskUserPromptDelivery({
        toolCallId: "call-readiness-expired",
        sessionKey,
        questions,
        timeoutSeconds: 1,
      });
      if (!reservation) {
        throw new Error("expected prompt reservation");
      }
      const gatewayResult = createDeferred<unknown>();
      const pending = waitForAskUserPromptReady(
        reservation.questionId,
        async () => await gatewayResult.promise,
      );

      await vi.advanceTimersByTimeAsync(1_000);
      gatewayResult.resolve({ questions: [] });

      await expect(pending).resolves.toBeUndefined();
      expect(
        reserveAskUserPromptDelivery({
          toolCallId: "call-after-readiness-expired",
          sessionKey,
          questions,
        }),
      ).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a renewed reservation ready after an earlier status read expires", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    try {
      const questions = normalizeAskUserParams(validArgs).questions;
      const sessionKey = "agent:main:readiness-renewal";
      const toolCallId = "call-readiness-renewal";
      const reservation = reserveAskUserPromptDelivery({
        toolCallId,
        sessionKey,
        questions,
        timeoutSeconds: 1,
      });
      if (!reservation) {
        throw new Error("expected prompt reservation");
      }
      const firstStatus = createDeferred<unknown>();
      const request = createDeferred<unknown>();
      let listCalls = 0;
      const gateway = vi.fn(async (method: string) => {
        if (method === "question.list") {
          listCalls += 1;
          return listCalls === 1
            ? await firstStatus.promise
            : { questions: [{ id: reservation.questionId, status: "pending" }] };
        }
        if (method === "question.request") {
          return await request.promise;
        }
        if (method === "question.waitAnswer") {
          return { status: "cancelled" };
        }
        throw new Error(`unexpected method ${method}`);
      });

      const gatewayCall = gateway as unknown as GatewayCall;
      const readiness = waitForAskUserPromptReady(reservation.questionId, gatewayCall);
      const execution = createAskUserTool({ sessionKey, gatewayCall }).execute(toolCallId, {
        ...validArgs,
        timeoutSeconds: 30,
      });
      await vi.waitFor(() =>
        expect(gateway).toHaveBeenCalledWith(
          "question.request",
          expect.anything(),
          expect.anything(),
        ),
      );

      await vi.advanceTimersByTimeAsync(1_000);
      firstStatus.resolve({ questions: [] });
      await vi.advanceTimersByTimeAsync(50);

      await expect(readiness).resolves.toEqual(questions);
      request.resolve({ id: reservation.questionId });
      await expect(execution).resolves.toMatchObject({ details: { status: "no_answer" } });
    } finally {
      vi.useRealTimers();
    }
  });
});
