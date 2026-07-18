import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Question, QuestionAnswers } from "../../packages/gateway-protocol/src/index.js";
import {
  QuestionManager,
  QuestionManagerError,
  QuestionManagerErrorCodes,
} from "./question-manager.js";

const QUESTION_RESOLVED_ENTRY_GRACE_MS = 15_000;

const questions: Question[] = [
  {
    id: "choice",
    header: "Choice",
    question: "Which option?",
    options: [
      { label: "One", description: "First" },
      { label: "Two", description: "Second" },
    ],
    isOther: true,
  },
];
const answers = { answers: { choice: { answers: ["Two"] } } };

const invalidAnswerCases: Array<[string, Question[], QuestionAnswers, string]> = [
  ["an empty answer map", questions, { answers: {} }, "choice"],
  [
    "an unknown question id",
    questions,
    { answers: { choice: { answers: ["Two"] }, unknown: { answers: ["value"] } } },
    "unknown",
  ],
  [
    "a missing question answer",
    [...questions, { ...questions[0]!, id: "second" }],
    answers,
    "second",
  ],
  ["an empty string", questions, { answers: { choice: { answers: ["  "] } } }, "choice"],
  [
    "multiple values for a single-select question",
    questions,
    { answers: { choice: { answers: ["One", "Two"] } } },
    "choice",
  ],
  [
    "a value outside the declared options",
    [{ ...questions[0]!, isOther: false }],
    { answers: { choice: { answers: ["Three"] } } },
    "choice",
  ],
];

let manager: QuestionManager;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  manager = new QuestionManager();
});

afterEach(() => {
  manager.reset();
  vi.useRealTimers();
});

describe("QuestionManager", () => {
  it("requests, gets, and deterministically lists pending questions", () => {
    const first = manager.request({ questions, timeoutMs: 10_000, agentId: "main" });
    vi.setSystemTime(1_001);
    const second = manager.request({
      questions: [{ ...questions[0]!, id: "other" }],
      timeoutMs: 10_000,
      sessionKey: "agent:main:main",
    });

    expect(manager.get(first.id)).toEqual(first);
    expect(manager.list().map((record) => record.id)).toEqual([first.id, second.id]);
  });

  it("accepts a unique client id and rejects reuse during the grace window", () => {
    const first = manager.request({ id: "ask_client_id", questions, timeoutMs: 10_000 });

    expect(first.id).toBe("ask_client_id");
    expect(() =>
      manager.request({ id: "ask_client_id", questions, timeoutMs: 10_000 }),
    ).toThrowError(QuestionManagerError);
    try {
      manager.request({ id: "ask_client_id", questions, timeoutMs: 10_000 });
    } catch (error) {
      expect(error).toMatchObject({ code: QuestionManagerErrorCodes.ID_IN_USE });
    }
  });

  it("releases waitAnswer with the submitted answer", async () => {
    const record = manager.request({ questions, timeoutMs: 10_000 });
    const waiting = manager.waitAnswer(record.id);

    expect(manager.resolve(record.id, answers, "control-ui")).toEqual({
      status: "answered",
      answers,
    });
    await expect(waiting).resolves.toEqual({ status: "answered", answers });
    expect(manager.get(record.id)).toMatchObject({ status: "answered", resolvedBy: "control-ui" });
  });

  it.each(invalidAnswerCases)(
    "rejects %s without terminalizing",
    (_name, requestQuestions, invalid, questionId) => {
      const record = manager.request({ questions: [...requestQuestions], timeoutMs: 10_000 });

      expect(() => manager.resolve(record.id, invalid)).toThrow(`question '${questionId}'`);
      expect(manager.get(record.id)?.status).toBe("pending");
    },
  );

  it("accepts trimmed option labels and free text when allowed", () => {
    const strict = manager.request({
      questions: [{ ...questions[0]!, isOther: false }],
      timeoutMs: 10_000,
    });
    expect(
      manager.resolve(strict.id, { answers: { choice: { answers: ["  Two  "] } } }),
    ).toMatchObject({ status: "answered" });

    const open = manager.request({ questions, timeoutMs: 10_000 });
    expect(
      manager.resolve(open.id, { answers: { choice: { answers: ["custom"] } } }),
    ).toMatchObject({ status: "answered" });

    const freeText = manager.request({
      questions: [{ ...questions[0]!, options: [], isOther: false }],
      timeoutMs: 10_000,
    });
    expect(
      manager.resolve(freeText.id, { answers: { choice: { answers: ["custom"] } } }),
    ).toMatchObject({ status: "answered" });
  });

  it("times out one waiter without resolving the question", async () => {
    const record = manager.request({ questions, timeoutMs: 10_000 });
    const waiting = manager.waitAnswer(record.id, 50);

    await vi.advanceTimersByTimeAsync(50);

    await expect(waiting).resolves.toEqual({ status: "pending" });
    expect(manager.get(record.id)?.status).toBe("pending");
  });

  it("expires pending questions and emits the terminal event", async () => {
    const onResolved = vi.fn();
    const record = manager.request({ questions, timeoutMs: 50, onResolved });
    const waiting = manager.waitAnswer(record.id);

    await vi.advanceTimersByTimeAsync(50);

    await expect(waiting).resolves.toEqual({ status: "expired" });
    expect(manager.get(record.id)?.status).toBe("expired");
    expect(onResolved).toHaveBeenCalledWith({ id: record.id, status: "expired" });
  });

  it("cancels pending questions", async () => {
    const record = manager.request({ questions, timeoutMs: 10_000 });
    const waiting = manager.waitAnswer(record.id);

    expect(manager.cancel(record.id, "agent")).toEqual({ status: "cancelled" });
    await expect(waiting).resolves.toEqual({ status: "cancelled" });
    expect(manager.get(record.id)).toMatchObject({ status: "cancelled", resolvedBy: "agent" });
  });

  it("rejects double resolve and resolve after expiry with typed errors", async () => {
    const answered = manager.request({ questions, timeoutMs: 10_000 });
    manager.resolve(answered.id, answers);

    expect(() => manager.resolve(answered.id, answers)).toThrowError(QuestionManagerError);
    try {
      manager.resolve(answered.id, answers);
    } catch (error) {
      expect(error).toMatchObject({ code: QuestionManagerErrorCodes.ALREADY_TERMINAL });
    }

    const expired = manager.request({ questions, timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    try {
      manager.resolve(expired.id, answers);
      throw new Error("expected resolve to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: QuestionManagerErrorCodes.ALREADY_TERMINAL });
    }
  });

  it("keeps terminal records through the grace window", async () => {
    const record = manager.request({ questions, timeoutMs: 10_000 });
    manager.resolve(record.id, answers);

    await vi.advanceTimersByTimeAsync(QUESTION_RESOLVED_ENTRY_GRACE_MS - 1);
    expect(manager.get(record.id)?.status).toBe("answered");

    await vi.advanceTimersByTimeAsync(1);
    expect(manager.get(record.id)).toBeNull();
  });
});

describe("answer canonicalization", () => {
  it("stores declared option labels for trim-variant submissions", () => {
    const localManager = new QuestionManager();
    const record = localManager.request({
      questions: [
        {
          id: "pick",
          header: "Pick",
          question: "Pick one",
          options: [{ label: "Two" }, { label: "Three" }],
          isOther: false,
        },
      ],
      timeoutMs: 60_000,
    });
    const result = localManager.resolve(record.id, {
      answers: { pick: { answers: ["  Two  "] } },
    });
    expect(result).toEqual({
      status: "answered",
      answers: { answers: { pick: { answers: ["Two"] } } },
    });
    localManager.reset();
  });
});
