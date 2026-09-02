/* @vitest-environment jsdom */

// Control UI tests cover composer-only pending questions and terminal transcript summaries.
import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import type { QuestionPrompt } from "../../app/question-prompt.ts";
import { buildCachedChatItems, coalesceStreamRuns, resetChatThreadState } from "./chat-thread.ts";
import { renderChatQuestionSummary } from "./components/chat-question-card.ts";

function prompt(status: QuestionPrompt["status"]): QuestionPrompt {
  return {
    id: "question-1",
    questions: [
      {
        questionId: "format",
        header: "Format",
        question: "Which format?",
        options: [{ label: "Compact" }, { label: "Detailed" }],
        isOther: true,
      },
    ],
    sessionKey: "agent:main:main",
    runId: "run-question",
    createdAtMs: 1_000,
    expiresAtMs: 60_000,
    status,
    answeredElsewhere: false,
    localResolutionConfirmed: false,
    locallyExpired: false,
    submitting: false,
    error: null,
    drafts: new Map(),
    revision: 1,
  };
}

function items(question: QuestionPrompt, runActive: boolean, messages: unknown[] = []) {
  return buildCachedChatItems({
    paneId: `pane-${question.status}`,
    sessionKey: "agent:main:main",
    messages,
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    queue: [],
    showToolCalls: true,
    runWorking: runActive,
    runActive,
    questionPrompts: [question],
  });
}

afterEach(() => resetChatThreadState());

describe("question chat items", () => {
  it("keeps a pending question out of the message stream", () => {
    const result = coalesceStreamRuns(items(prompt("pending"), true));
    const run = result.find((item) => item.kind === "stream-run");

    expect(run?.kind).toBe("stream-run");
    expect(run?.kind === "stream-run" ? run.parts.map((part) => part.kind) : []).toEqual([
      "reading-indicator",
    ]);
  });

  it("keeps a terminal question as a stable transcript item", () => {
    const result = coalesceStreamRuns(items(prompt("expired"), false));

    expect(result).toMatchObject([{ kind: "question", questionId: "question-1" }]);
  });

  it("keeps a terminal question between the surrounding transcript turns", () => {
    const result = items(prompt("answered"), false, [
      {
        role: "user",
        content: "First prompt",
        timestamp: 900,
        __openclaw: { idempotencyKey: "run-question:user" },
      },
      { role: "assistant", content: "First reply", timestamp: 1_300 },
      { role: "user", content: "Next prompt", timestamp: 2_000 },
    ]);

    expect(result.map((item) => (item.kind === "group" ? item.role : item.kind))).toEqual([
      "user",
      "question",
      "assistant",
      "user",
    ]);
  });

  it("renders answered and skipped prompts as compact summary lines", () => {
    const answered = prompt("answered");
    answered.answers = { answers: { format: ["Compact"] } };
    const skipped = prompt("cancelled");
    const container = document.createElement("div");

    render(renderChatQuestionSummary(answered), container);
    expect(
      container.querySelector(".chat-question-summary")?.textContent?.replace(/\s+/g, " "),
    ).toContain("Format: Compact");

    render(renderChatQuestionSummary(skipped), container);
    expect(
      container.querySelector(".chat-question-summary")?.textContent?.replace(/\s+/g, " "),
    ).toContain("Format: Skipped");
    expect(container.querySelector(".chat-question-panel")).toBeNull();
  });

  it("keeps supplied answer labels when another client resolved the question", () => {
    const answered = prompt("answered");
    answered.answeredElsewhere = true;
    answered.answers = { answers: { format: ["Detailed"] } };
    const container = document.createElement("div");

    render(renderChatQuestionSummary(answered), container);

    expect(
      container.querySelector(".chat-question-summary")?.textContent?.replace(/\s+/g, " "),
    ).toContain("Format: Detailed");
  });

  it("never echoes a secret answer in the terminal transcript summary", () => {
    const answered = prompt("answered");
    answered.questions = [
      {
        questionId: "api_key",
        header: "API key",
        question: "Provide the deployment API key",
        options: [],
        isSecret: true,
        secretStore: { name: "FAKE_DEPLOYMENT_API_KEY", kind: "secret" },
      },
    ];
    answered.answeredElsewhere = true;
    answered.answers = { answers: { api_key: ["fake-secret-never-render"] } };
    const container = document.createElement("div");

    render(renderChatQuestionSummary(answered), container);

    expect(container.textContent?.replace(/\s+/g, " ")).toContain("API key: Answered");
    expect(container.textContent).not.toContain("fake-secret-never-render");
    expect(container.innerHTML).not.toContain("fake-secret-never-render");
  });

  it.each(["pending", "answered", "expired", "cancelled"] as const)(
    "scopes %s questions to the selected session and its equivalent alias",
    (status) => {
      const question = prompt(status);
      const expected =
        status === "pending"
          ? []
          : [
              {
                kind: "question",
                key: "question:question-1",
                questionId: "question-1",
                startedAt: 1_000,
              },
            ];

      expect(items(question, false)).toEqual(expected);
      expect(items({ ...question, sessionKey: "main" }, false)).toEqual(expected);
      expect(items({ ...question, sessionKey: "agent:other:main" }, false)).toEqual([]);
    },
  );
});
