import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  QuestionRecordSchema,
  QuestionWaitAnswerResultSchema,
  validateQuestionRequestParams,
  validateQuestionResolveParams,
  validateQuestionWaitAnswerParams,
} from "./index.js";

const question = {
  questionId: "choice",
  header: "Choice",
  question: "Which option?",
  options: [{ label: "One", description: "First" }, { label: "Two" }],
  multiSelect: false,
  isOther: true,
  isSecret: false,
};
const answers = { answers: { choice: ["Two"] } };

describe("question protocol validators", () => {
  it("validates method params", () => {
    expect(
      validateQuestionRequestParams({
        id: "client-question-id",
        runId: "agent-run-id",
        questions: [question],
        timeoutMs: 100,
      }),
    ).toBe(true);
    expect(validateQuestionWaitAnswerParams({ id: "question-uuid", timeoutMs: 50 })).toBe(true);
    expect(validateQuestionResolveParams({ id: "question-uuid", answers })).toBe(true);
    expect(validateQuestionResolveParams({ id: "question-uuid", cancel: true })).toBe(true);
    expect(
      Value.Check(QuestionRecordSchema, {
        id: "client-question-id",
        runId: "agent-run-id",
        questions: [question],
        createdAtMs: 1,
        expiresAtMs: 2,
        status: "pending",
      }),
    ).toBe(true);
  });

  it.each([undefined, "candidate-resolution", "", "x".repeat(129)])(
    "validates bounded optional resolution correlation: %s",
    (resolutionId) => {
      const valid = resolutionId === undefined || resolutionId === "candidate-resolution";
      const receipt = resolutionId === undefined ? {} : { resolutionId };
      expect(validateQuestionResolveParams({ id: "question-uuid", answers, ...receipt })).toBe(
        valid,
      );
      expect(
        Value.Check(QuestionWaitAnswerResultSchema, { status: "answered", answers, ...receipt }),
      ).toBe(valid);
    },
  );

  it("requires an explicit boolean to opt into resolution receipts", () => {
    expect(
      validateQuestionWaitAnswerParams({ id: "question-uuid", includeResolutionId: true }),
    ).toBe(true);
    expect(
      validateQuestionWaitAnswerParams({ id: "question-uuid", includeResolutionId: "true" }),
    ).toBe(false);
  });

  it("enforces the shared question header cap", () => {
    expect(
      validateQuestionRequestParams({
        questions: [{ ...question, header: "longer than twelve" }],
      }),
    ).toBe(false);
    expect(validateQuestionRequestParams({ questions: [] })).toBe(false);
    expect(
      validateQuestionRequestParams({ questions: [question, question, question, question] }),
    ).toBe(false);
  });
});
