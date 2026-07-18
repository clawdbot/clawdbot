// Control UI tests cover question-card placement in live and terminal chat runs.
import { afterEach, describe, expect, it } from "vitest";
import type { QuestionPrompt } from "../../app/question-prompt.ts";
import { buildCachedChatItems, coalesceStreamRuns, resetChatThreadState } from "./chat-thread.ts";

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
  it("groups a pending question with the active run and plan", () => {
    const result = coalesceStreamRuns(items(prompt("pending"), true));
    const run = result.find((item) => item.kind === "stream-run");

    expect(run?.kind).toBe("stream-run");
    expect(run?.kind === "stream-run" ? run.parts.map((part) => part.kind) : []).toEqual([
      "question",
      "reading-indicator",
      "plan",
    ]);
  });

  it("keeps a terminal question as a stable transcript item", () => {
    const result = coalesceStreamRuns(items(prompt("expired"), false));

    expect(result).toMatchObject([{ kind: "question", questionId: "question-1", pending: false }]);
  });

  it("omits questions belonging to another session", () => {
    const other = prompt("pending");
    other.sessionKey = "agent:other:main";

    expect(items(other, false)).toEqual([]);
  });
});
