// Covers compact question-button resolution through a stubbed Gateway.
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
      id: "deploy_target",
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

  it("maps the compact option index to the canonical question id and label", async () => {
    hoisted.callGateway.mockResolvedValueOnce({ question: pendingRecord }).mockResolvedValueOnce({
      status: "answered",
      answers: { answers: { deploy_target: { answers: ["Production"] } } },
    });

    await expect(
      resolveQuestionOverGateway({
        cfg: {} as never,
        questionId: recordId,
        optionIndex: 1,
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
            answers: { answers: { deploy_target: { answers: ["Production"] } } },
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
        resolveQuestionOverGateway({ cfg: {} as never, questionId: recordId, optionIndex: 0 }),
      ).resolves.toEqual({ status: "already-terminal", reason: expectedReason });
    },
  );

  it("does not resolve an already-terminal record", async () => {
    hoisted.callGateway.mockResolvedValueOnce({
      question: { ...pendingRecord, status: "expired" },
    });

    await expect(
      resolveQuestionOverGateway({ cfg: {} as never, questionId: recordId, optionIndex: 0 }),
    ).resolves.toEqual({ status: "already-terminal", reason: "already-terminal" });
    expect(hoisted.callGateway).toHaveBeenCalledOnce();
  });

  it("rejects invalid indices before resolving", async () => {
    hoisted.callGateway.mockResolvedValueOnce({ question: pendingRecord });

    await expect(
      resolveQuestionOverGateway({ cfg: {} as never, questionId: recordId, optionIndex: 2 }),
    ).rejects.toThrow("out of range");
    expect(hoisted.callGateway).toHaveBeenCalledOnce();
  });

  it("never partially resolves a multi-question record", async () => {
    hoisted.callGateway.mockResolvedValueOnce({
      question: {
        ...pendingRecord,
        questions: [
          ...pendingRecord.questions,
          {
            id: "region",
            header: "Region",
            question: "Which region?",
            options: [{ label: "EU" }, { label: "US" }],
          },
        ],
      },
    });

    await expect(
      resolveQuestionOverGateway({ cfg: {} as never, questionId: recordId, optionIndex: 0 }),
    ).rejects.toThrow("one tappable question");
    expect(hoisted.callGateway).toHaveBeenCalledOnce();
  });
});
