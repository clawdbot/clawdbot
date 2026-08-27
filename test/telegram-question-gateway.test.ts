// Root-owned integration may combine public plugin surfaces with Gateway-owned runtime.
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { telegramOutbound } from "../extensions/telegram/api.js";
import { buildAgentHarnessQuestionPromptPayload } from "../src/agents/harness/user-input-bridge.js";
import { QuestionManager } from "../src/gateway/question-manager.js";
import { createQuestionHandlers } from "../src/gateway/server-methods/question.js";
import { createSecretStoreWriteService } from "../src/gateway/server-methods/secrets.js";
import { callGatewayHandler } from "../src/gateway/server-methods/skills.test-helpers.js";

type QuestionGatewayCall = { method: string; params?: Record<string, unknown> };

const questionGatewayTransport = vi.hoisted(() => ({
  dispatch: undefined as ((request: QuestionGatewayCall) => Promise<unknown>) | undefined,
}));

vi.mock("../src/gateway/call.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/gateway/call.js")>();
  return {
    ...actual,
    callGateway: async (request: QuestionGatewayCall) => {
      if (!questionGatewayTransport.dispatch) {
        throw new Error("expected the in-process question Gateway transport");
      }
      return await questionGatewayTransport.dispatch(request);
    },
  };
});

afterEach(() => {
  questionGatewayTransport.dispatch = undefined;
});

describe("Telegram question Gateway resolution", () => {
  it("resolves canonical option C when rendered option A repeats across blocks", async () => {
    const manager = new QuestionManager();
    const handlers = createQuestionHandlers(
      manager,
      createSecretStoreWriteService({ reloadSecrets: async () => ({ warningCount: 0 }) }),
    );
    const gatewayCalls: string[] = [];
    const dispatch = async ({ method, params }: QuestionGatewayCall): Promise<unknown> => {
      gatewayCalls.push(method);
      const result = await callGatewayHandler(handlers, method, params ?? {}, {
        context: { broadcast: () => undefined },
      });
      if (!result.ok) {
        throw new Error(`question Gateway method ${method} rejected its request`);
      }
      return result.response;
    };
    questionGatewayTransport.dispatch = dispatch;

    try {
      const questionId = "ask_0123456789abcdef0123456789abcdef";
      const optionValues = ["A", "B", "C"];
      await dispatch({
        method: "question.request",
        params: {
          id: questionId,
          questions: [
            {
              questionId: "destination",
              header: "Destination",
              question: "Where next?",
              options: optionValues.map((label) => ({ label })),
              multiSelect: false,
              isOther: false,
              isSecret: false,
            },
          ],
          timeoutMs: 15_000,
        },
      });
      expect(manager.get(questionId)?.questions[0]?.options).toEqual(
        optionValues.map((label) => ({ label })),
      );

      const questionButton = (optionValue: string) => ({
        label: optionValue,
        action: { type: "question" as const, questionId, optionValue },
      });
      const presentation = {
        blocks: [
          { type: "buttons" as const, buttons: [questionButton("C"), questionButton("A")] },
          { type: "buttons" as const, buttons: [questionButton("A"), questionButton("B")] },
        ],
      };
      const payload = buildAgentHarnessQuestionPromptPayload({
        questionId,
        questions: [
          {
            id: "destination",
            header: "Destination",
            question: "Where next?",
            options: optionValues.map((label) => ({ label })),
          },
        ],
        options: { presentation },
      });
      expect(payload.channelData.askUser).toEqual({ questionId, optionValues });
      const rendered = await telegramOutbound.renderPresentation?.({
        payload,
        presentation,
        ctx: { cfg: {}, to: "42", text: payload.text, payload },
      });
      const telegram = rendered?.channelData?.telegram as
        | { buttons?: ReadonlyArray<ReadonlyArray<{ callback_data?: string }>> }
        | undefined;
      const rows = telegram?.buttons;
      expect(rows?.map((row) => row.length)).toEqual([2, 2]);
      expect(rows?.flatMap((row) => row.map((button) => button.callback_data))).toEqual([
        `tgq1:${questionId}:2`,
        `tgq1:${questionId}:0`,
        `tgq1:${questionId}:0`,
        `tgq1:${questionId}:1`,
      ]);

      const callbackData = rows?.[0]?.[0]?.callback_data;
      if (!callbackData) {
        throw new Error("expected canonical Telegram option C callback data");
      }
      const optionIndex = Number(callbackData.slice(`tgq1:${questionId}:`.length));
      expect(optionIndex).toBe(2);

      await expect(
        questionGatewayRuntime.resolveOption({ cfg: {}, questionId, optionIndex, senderId: "42" }),
      ).resolves.toEqual({ status: "answered", questionId: "destination", optionValue: "C" });
      expect(gatewayCalls).toEqual(["question.request", "question.get", "question.resolve"]);
      expect(manager.get(questionId)).toMatchObject({
        status: "answered",
        answers: { answers: { destination: ["C"] } },
        resolvedBy: "42",
      });
    } finally {
      manager.reset();
    }
  });
});
