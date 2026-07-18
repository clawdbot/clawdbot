import { describe, expect, it } from "vitest";
import {
  validateQuestionGetResult,
  validateQuestionListResult,
  validateQuestionRequestedEvent,
  validateQuestionRequestParams,
  validateQuestionRequestResult,
  validateQuestionResolvedEvent,
  validateQuestionResolveParams,
  validateQuestionResolveResult,
  validateQuestionWaitAnswerParams,
  validateQuestionWaitAnswerResult,
} from "./index.js";

const question = {
  id: "choice",
  header: "Choice",
  question: "Which option?",
  options: [{ label: "One", description: "First" }, { label: "Two" }],
  multiSelect: false,
  isOther: true,
  isSecret: false,
};
const answers = { answers: { choice: { answers: ["Two"] } } };
const pendingRecord = {
  id: "question-uuid",
  questions: [question],
  agentId: "main",
  sessionKey: "agent:main:main",
  createdAtMs: 1,
  expiresAtMs: 2,
  status: "pending",
};

describe("question protocol validators", () => {
  it("round-trips method params and results", () => {
    expect(
      validateQuestionRequestParams({
        id: "client-question-id",
        questions: [question],
        timeoutMs: 100,
      }),
    ).toBe(true);
    expect(validateQuestionRequestResult({ id: "question-uuid", expiresAtMs: 2 })).toBe(true);
    expect(validateQuestionWaitAnswerParams({ id: "question-uuid", timeoutMs: 50 })).toBe(true);
    expect(validateQuestionWaitAnswerResult({ status: "pending" })).toBe(true);
    expect(validateQuestionWaitAnswerResult({ status: "answered", answers })).toBe(true);
    expect(validateQuestionResolveParams({ id: "question-uuid", answers })).toBe(true);
    expect(validateQuestionResolveParams({ id: "question-uuid", cancel: true })).toBe(true);
    expect(validateQuestionResolveResult({ status: "cancelled" })).toBe(true);
    expect(validateQuestionGetResult({ question: pendingRecord })).toBe(true);
    expect(validateQuestionListResult({ questions: [pendingRecord] })).toBe(true);
  });

  it("round-trips requested and resolved events", () => {
    expect(validateQuestionRequestedEvent(pendingRecord)).toBe(true);
    expect(
      validateQuestionResolvedEvent({ id: "question-uuid", status: "answered", answers }),
    ).toBe(true);
    expect(validateQuestionResolvedEvent({ id: "question-uuid", status: "expired" })).toBe(true);
  });

  it("keeps records normalized while allowing request-boundary header truncation", () => {
    expect(
      validateQuestionRequestParams({
        questions: [{ ...question, header: "longer than twelve" }],
      }),
    ).toBe(true);
    expect(
      validateQuestionRequestedEvent({
        ...pendingRecord,
        questions: [{ ...question, header: "longer than twelve" }],
      }),
    ).toBe(false);
    expect(validateQuestionRequestParams({ questions: [] })).toBe(false);
    expect(
      validateQuestionRequestParams({ questions: [question, question, question, question] }),
    ).toBe(false);
  });
});
