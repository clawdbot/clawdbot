// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createQuestionPromptState,
  disposeQuestionPromptState,
  handleQuestionPromptEvent,
  setQuestionPromptClient,
  submitQuestionPrompt,
} from "./question-prompt.ts";

const states: Array<ReturnType<typeof createQuestionPromptState>> = [];

afterEach(() => {
  for (const state of states.splice(0)) {
    disposeQuestionPromptState(state);
  }
});

describe("question prompt Control Model command", () => {
  it("preserves prompt lifecycle state around the selected command", async () => {
    const request = vi.fn();
    const command = vi.fn(async (input) => ({
      status: "answered",
      answers: input.answers,
    }));
    const state = createQuestionPromptState(vi.fn());
    states.push(state);
    setQuestionPromptClient(state, { request });
    handleQuestionPromptEvent(state, {
      event: "question.requested",
      payload: {
        id: "question-1",
        questions: [
          {
            questionId: "format",
            header: "Format",
            question: "Which format?",
            options: [{ label: "Detailed" }],
          },
        ],
        sessionKey: "agent:main:one",
        createdAtMs: 1_000,
        expiresAtMs: Date.now() + 60_000,
        status: "pending",
      },
    });

    await submitQuestionPrompt(state, "question-1", { format: ["Detailed"] }, command);

    expect(command).toHaveBeenCalledWith({
      id: "question-1",
      expiresAtMs: expect.any(Number),
      answers: { answers: { format: ["Detailed"] } },
    });
    expect(request).not.toHaveBeenCalled();
    expect(state.prompts.get("question-1")).toMatchObject({
      status: "answered",
      localResolutionConfirmed: true,
      submitting: false,
    });
  });
});
