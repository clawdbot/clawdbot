import { describe, expect, it } from "vitest";
import {
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
        questions: [question],
        timeoutMs: 100,
      }),
    ).toBe(true);
    expect(validateQuestionWaitAnswerParams({ id: "question-uuid", timeoutMs: 50 })).toBe(true);
    expect(validateQuestionResolveParams({ id: "question-uuid", answers })).toBe(true);
    expect(validateQuestionResolveParams({ id: "question-uuid", cancel: true })).toBe(true);
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
