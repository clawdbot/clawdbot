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
        id: "format",
        header: "Format",
        question: "Which format?",
        options: [{ label: "Compact" }, { label: "Detailed" }],
        isOther: true,
      },
    ],
    sessionKey: "agent:main:main",
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

function items(question: QuestionPrompt, runActive: boolean) {
  return buildCachedChatItems({
    paneId: `pane-${question.status}`,
    sessionKey: "agent:main:main",
    messages: [],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    queue: [],
    showToolCalls: true,
    runWorking: runActive,
    runActive,
    planStatus: runActive
      ? { steps: [{ step: "Wait for the answer", status: "in_progress" }] }
      : null,
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
      "plan",
    ]);
  });

  it("keeps a terminal question as a stable transcript item", () => {
    const result = coalesceStreamRuns(items(prompt("expired"), false));

    expect(result).toMatchObject([{ kind: "question", questionId: "question-1" }]);
  });

  it("renders answered and skipped prompts as compact summary lines", () => {
    const answered = prompt("answered");
    answered.answers = { answers: { format: { answers: ["Compact"] } } };
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
    answered.answers = { answers: { format: { answers: ["Detailed"] } } };
    const container = document.createElement("div");

    render(renderChatQuestionSummary(answered), container);

    expect(
      container.querySelector(".chat-question-summary")?.textContent?.replace(/\s+/g, " "),
    ).toContain("Format: Detailed");
  });

  it("omits questions belonging to another session", () => {
    const other = prompt("pending");
    other.sessionKey = "agent:other:main";

    expect(items(other, false)).toEqual([]);
  });
});
