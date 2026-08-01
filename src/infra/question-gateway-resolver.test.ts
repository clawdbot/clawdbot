// Covers question-button value resolution through a stubbed Gateway.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveQuestionOverGateway } from "./question-gateway-resolver.js";

const hoisted = vi.hoisted(() => ({ callGateway: vi.fn() }));

vi.mock("../gateway/call.js", () => ({ callGateway: hoisted.callGateway }));

const recordId = "ask_0123456789abcdef0123456789abcdef";
const pendingRecord = {
  id: recordId,
  status: "pending",
  questions: [
    {
      questionId: "deploy_target",
      header: "Target",
      question: "Where should this deploy?",
      options: [{ label: "Staging" }, { label: "Production" }],
    },
  ],
  createdAtMs: 1,
  expiresAtMs: 2,
} as const;

function terminalError(reason: "QUESTION_ALREADY_TERMINAL" | "QUESTION_NOT_FOUND") {
  return Object.assign(new Error(reason), {
    name: "GatewayClientRequestError",
    details: { reason },
  });
}

describe("resolveQuestionOverGateway", () => {
  beforeEach(() => {
    hoisted.callGateway.mockReset();
  });

  it("maps the rendered option value to the canonical question id", async () => {
    hoisted.callGateway.mockResolvedValueOnce({ question: pendingRecord }).mockResolvedValueOnce({
      status: "answered",
      answers: { answers: { deploy_target: ["Production"] } },
    });

    await expect(
      resolveQuestionOverGateway({
        cfg: {} as never,
        questionId: recordId,
        optionValue: "Production",
        senderId: "telegram:42",
      }),
    ).resolves.toEqual({
      status: "answered",
      questionId: "deploy_target",
      optionValue: "Production",
    });
    expect(hoisted.callGateway.mock.calls).toEqual([
      [
        expect.objectContaining({
          method: "question.get",
          params: { id: recordId },
          scopes: ["operator.questions"],
        }),
      ],
      [
        expect.objectContaining({
          method: "question.resolve",
          params: {
            id: recordId,
            answers: { answers: { deploy_target: ["Production"] } },
            resolvedBy: "telegram:42",
          },
        }),
      ],
    ]);
  });

  it.each([
    ["question.get", "QUESTION_NOT_FOUND", "not-found"],
    ["question.resolve", "QUESTION_ALREADY_TERMINAL", "already-terminal"],
  ] as const)(
    "returns a terminal outcome when %s races",
    async (method, reason, expectedReason) => {
      if (method === "question.resolve") {
        hoisted.callGateway.mockResolvedValueOnce({ question: pendingRecord });
      }
      hoisted.callGateway.mockRejectedValueOnce(terminalError(reason));

      await expect(
        resolveQuestionOverGateway({
          cfg: {} as never,
          questionId: recordId,
          optionValue: "Staging",
        }),
      ).resolves.toEqual({ status: "already-terminal", reason: expectedReason });
    },
  );

  it("does not resolve an already-terminal record", async () => {
    hoisted.callGateway.mockResolvedValueOnce({
      question: { ...pendingRecord, status: "expired" },
    });

    await expect(
      resolveQuestionOverGateway({
        cfg: {} as never,
        questionId: recordId,
        optionValue: "Staging",
      }),
    ).resolves.toEqual({ status: "already-terminal", reason: "already-terminal" });
    expect(hoisted.callGateway).toHaveBeenCalledOnce();
  });

  it("leaves option membership validation to question.resolve", async () => {
    hoisted.callGateway
      .mockResolvedValueOnce({ question: pendingRecord })
      .mockRejectedValueOnce(new Error("invalid answer"));

    await expect(
      resolveQuestionOverGateway({ cfg: {} as never, questionId: recordId, optionValue: "Other" }),
    ).rejects.toThrow("invalid answer");
    expect(hoisted.callGateway).toHaveBeenCalledTimes(2);
  });

  it("never partially resolves a multi-question record", async () => {
    hoisted.callGateway.mockResolvedValueOnce({
      question: {
        ...pendingRecord,
        questions: [
          ...pendingRecord.questions,
          {
            questionId: "region",
            header: "Region",
            question: "Which region?",
            options: [{ label: "EU" }, { label: "US" }],
          },
        ],
      },
    });

    await expect(
      resolveQuestionOverGateway({
        cfg: {} as never,
        questionId: recordId,
        optionValue: "Staging",
      }),
    ).rejects.toThrow("one tappable question");
    expect(hoisted.callGateway).toHaveBeenCalledOnce();
  });
});
