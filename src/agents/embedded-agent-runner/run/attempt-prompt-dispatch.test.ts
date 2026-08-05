import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  observeEmbeddedAttemptPrompt: vi.fn(),
  prepareEmbeddedAttemptPromptExecution: vi.fn(),
  prepareEmbeddedAttemptPromptPreflight: vi.fn(),
  submitEmbeddedAttemptPrompt: vi.fn(),
}));

vi.mock("./attempt-prompt-execution-prepare.js", () => ({
  prepareEmbeddedAttemptPromptExecution: hoisted.prepareEmbeddedAttemptPromptExecution,
}));
vi.mock("./attempt-prompt-observability.js", () => ({
  observeEmbeddedAttemptPrompt: hoisted.observeEmbeddedAttemptPrompt,
}));
vi.mock("./attempt-prompt-preflight.js", () => ({
  prepareEmbeddedAttemptPromptPreflight: hoisted.prepareEmbeddedAttemptPromptPreflight,
}));
vi.mock("./attempt-prompt-submit.js", () => ({
  submitEmbeddedAttemptPrompt: hoisted.submitEmbeddedAttemptPrompt,
}));

import { dispatchEmbeddedAttemptPrompt } from "./attempt-prompt-dispatch.js";

type DispatchInput = Parameters<typeof dispatchEmbeddedAttemptPrompt>[0];
type PreflightMockInput = { state: DispatchInput["state"] };

function createInput(overrides: Partial<DispatchInput> = {}): DispatchInput {
  return {
    attempt: { runId: "run-1", sessionId: "session-1" },
    activeSession: { messages: [] },
    promptContext: {
      contextTokenBudget: 8_000,
      effectivePrompt: "effective prompt",
      hookMessagesForCurrentPrompt: [],
      llmBoundaryPromptForPrecheck: "boundary prompt",
      promptForModel: "model prompt",
      promptForSession: "session prompt",
      promptSubmission: { prompt: "submission prompt", runtimeOnly: false },
      promptToolResultAggregateMaxChars: 8_000,
      promptToolResultMaxChars: 4_000,
      runtimeContextMessageForCurrentTurn: { role: "custom", content: "runtime" },
      systemPromptForHook: "system prompt",
    },
    getCompactionReserveTokens: () => 1_000,
    publishState: vi.fn(),
    releaseLeasedSteering: vi.fn(),
    state: {
      contextBudgetStatus: undefined,
      preflightRecovery: undefined,
      promptError: null,
      promptErrorSource: null,
      skipPromptSubmission: false,
    },
    execution: {},
    observation: {},
    preflight: {},
    submission: {},
    ...overrides,
  } as unknown as DispatchInput;
}

describe("dispatchEmbeddedAttemptPrompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.prepareEmbeddedAttemptPromptExecution.mockResolvedValue({
      images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
      imageFactIndexes: [null],
      detectedRefs: [],
      failedMediaCount: 0,
      loadedCount: 1,
      skippedCount: 0,
    });
    hoisted.observeEmbeddedAttemptPrompt.mockReturnValue({ skipPromptSubmission: false });
    hoisted.prepareEmbeddedAttemptPromptPreflight.mockImplementation(
      async (input: PreflightMockInput) => input.state,
    );
    hoisted.submitEmbeddedAttemptPrompt.mockResolvedValue(undefined);
  });

  it("runs image preparation, observability, preflight, and submission in order", async () => {
    const order: string[] = [];
    hoisted.prepareEmbeddedAttemptPromptExecution.mockImplementationOnce(async () => {
      order.push("images");
      return {
        images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
        imageFactIndexes: [null],
        detectedRefs: [],
        failedMediaCount: 0,
        loadedCount: 1,
        skippedCount: 0,
      };
    });
    hoisted.observeEmbeddedAttemptPrompt.mockImplementationOnce(() => {
      order.push("observe");
      return { skipPromptSubmission: false };
    });
    hoisted.prepareEmbeddedAttemptPromptPreflight.mockImplementationOnce(
      async (input: PreflightMockInput) => {
        order.push("preflight");
        return input.state;
      },
    );
    hoisted.submitEmbeddedAttemptPrompt.mockImplementationOnce(async () => {
      order.push("submit");
    });
    const publishState = vi.fn(() => {
      order.push("publish");
    });
    const input = createInput({ publishState });

    await expect(dispatchEmbeddedAttemptPrompt(input)).resolves.toEqual(input.state);

    expect(order).toEqual(["images", "observe", "publish", "preflight", "publish", "submit"]);
    expect(hoisted.prepareEmbeddedAttemptPromptExecution).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "submission prompt", skipPromptSubmission: false }),
    );
    expect(hoisted.observeEmbeddedAttemptPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ imageCount: 1, reserveTokens: 1_000 }),
    );
    expect(hoisted.submitEmbeddedAttemptPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [expect.objectContaining({ type: "image" })],
        modelPrompt: "model prompt",
        runtimeContextMessage: expect.objectContaining({ content: "runtime" }),
        transcriptPrompt: "session prompt",
      }),
    );
  });

  it("releases steering when preflight skips provider submission", async () => {
    const promptError = new Error("preflight rejected");
    const releaseLeasedSteering = vi.fn();
    hoisted.observeEmbeddedAttemptPrompt.mockReturnValueOnce({ skipPromptSubmission: true });
    hoisted.prepareEmbeddedAttemptPromptPreflight.mockImplementationOnce(
      async (input: PreflightMockInput) => ({
        ...input.state,
        promptError,
        promptErrorSource: "precheck",
      }),
    );

    const result = await dispatchEmbeddedAttemptPrompt(createInput({ releaseLeasedSteering }));

    expect(result.promptError).toBe(promptError);
    expect(releaseLeasedSteering).toHaveBeenCalledWith(promptError);
    expect(hoisted.submitEmbeddedAttemptPrompt).not.toHaveBeenCalled();
  });

  it("publishes preflight state before a submission failure", async () => {
    const promptError = new Error("admission warning");
    const submitError = new Error("provider failed");
    const admittedState = {
      contextBudgetStatus: undefined,
      preflightRecovery: undefined,
      promptError,
      promptErrorSource: "precheck" as const,
      skipPromptSubmission: false,
    };
    const publishState = vi.fn();
    hoisted.prepareEmbeddedAttemptPromptPreflight.mockResolvedValueOnce(admittedState);
    hoisted.submitEmbeddedAttemptPrompt.mockRejectedValueOnce(submitError);

    await expect(dispatchEmbeddedAttemptPrompt(createInput({ publishState }))).rejects.toBe(
      submitError,
    );

    expect(publishState).toHaveBeenLastCalledWith(admittedState);
  });
});
