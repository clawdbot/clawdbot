import type { CliBackendExecuteContext } from "openclaw/plugin-sdk/cli-backend";
import { describe, expect, it, vi } from "vitest";
import { createClaudeCliUserInputAuthorizer } from "./cli-user-input.js";

function createContext(
  requestUserInput: CliBackendExecuteContext["requestUserInput"],
): CliBackendExecuteContext {
  return {
    command: "/usr/local/bin/claude",
    args: [],
    cwd: "/tmp",
    env: {},
    prompt: "test",
    modelId: "claude-sonnet-4-6",
    systemPrompt: "test",
    useResume: false,
    timeoutMs: 30_000,
    requestToolPermission: vi.fn(async () => ({
      behavior: "allow" as const,
      updatedInput: {},
    })),
    requestUserInput,
  };
}

const validOptions = [
  { label: "A", description: "First option." },
  { label: "B", description: "Second option." },
];

const input = {
  questions: [
    {
      header: "Test stack",
      question: "Which test runner should we use?",
      options: [
        { label: "Vitest", description: "Use the existing test stack." },
        { label: "Node test", description: "Use the built-in runner." },
      ],
      multiSelect: false,
    },
    {
      header: "Proof",
      question: "Which proof should we collect?",
      options: [
        { label: "Unit tests", description: "Exercise the adapter." },
        { label: "UI proof", description: "Capture the Control UI." },
      ],
      multiSelect: true,
    },
  ],
};

describe("Claude CLI user input adapter", () => {
  it("maps Claude questions and answers while deduplicating the CLI callbacks", async () => {
    const requestUserInput = vi.fn(async () => ({
      status: "answered" as const,
      answers: {
        question_1: ["Vitest"],
        question_2: ["Unit tests", "UI proof"],
      },
    }));
    const authorizer = createClaudeCliUserInputAuthorizer(createContext(requestUserInput));
    const signal = new AbortController().signal;

    const first = authorizer.authorize({ input, signal, toolUseId: "claude-question-1" });
    const second = authorizer.authorize({ input, signal, toolUseId: "claude-question-1" });

    await expect(first).resolves.toEqual({
      behavior: "allow",
      updatedInput: {
        ...input,
        answers: {
          "Which test runner should we use?": "Vitest",
          "Which proof should we collect?": "Unit tests, UI proof",
        },
      },
    });
    await expect(second).resolves.toEqual(await first);
    expect(requestUserInput).toHaveBeenCalledOnce();
    expect(requestUserInput).toHaveBeenCalledWith({
      toolName: "AskUserQuestion",
      intro: "Claude needs input:",
      toolCallId: "claude-question-1",
      abortSignal: signal,
      questions: [
        {
          id: "question_1",
          header: "Test stack",
          question: "Which test runner should we use?",
          multiSelect: false,
          isOther: true,
          options: [
            { label: "Vitest", description: "Use the existing test stack." },
            { label: "Node test", description: "Use the built-in runner." },
          ],
        },
        {
          id: "question_2",
          header: "Proof",
          question: "Which proof should we collect?",
          multiSelect: true,
          isOther: true,
          options: [
            { label: "Unit tests", description: "Exercise the adapter." },
            { label: "UI proof", description: "Capture the Control UI." },
          ],
        },
      ],
    });
  });

  it("returns actionable denial guidance when the operator skips", async () => {
    const authorizer = createClaudeCliUserInputAuthorizer(
      createContext(
        vi.fn(async () => ({
          status: "cancelled" as const,
          message: "The operator skipped this question.",
        })),
      ),
    );

    await expect(
      authorizer.authorize({ input, signal: new AbortController().signal }),
    ).resolves.toEqual({
      behavior: "deny",
      message: "The operator skipped this question. Continue with your best judgment.",
    });
  });

  it("guides a malformed question retry without replaying the rejected call", async () => {
    const requestUserInput = vi.fn(async () => ({
      status: "answered" as const,
      answers: { question_1: ["Vitest"], question_2: ["Unit tests"] },
    }));
    const authorizer = createClaudeCliUserInputAuthorizer(createContext(requestUserInput));
    const signal = new AbortController().signal;
    const rejected = {
      behavior: "deny",
      message:
        "OpenClaw rejected malformed Claude user questions: questions[0].header must be at most 12 characters. Correct the invalid field and retry AskUserQuestion.",
    };

    await expect(
      authorizer.authorize({
        input: { questions: [{ ...input.questions[0], header: "Too long for Claude" }] },
        signal,
        toolUseId: "rejected-question",
      }),
    ).resolves.toEqual(rejected);
    await expect(
      authorizer.authorize({ input, signal, toolUseId: "rejected-question" }),
    ).resolves.toEqual(rejected);
    expect(requestUserInput).not.toHaveBeenCalled();

    await expect(
      authorizer.authorize({ input, signal, toolUseId: "corrected-question" }),
    ).resolves.toMatchObject({
      behavior: "allow",
      updatedInput: {
        answers: {
          "Which test runner should we use?": "Vitest",
          "Which proof should we collect?": "Unit tests",
        },
      },
    });
    expect(requestUserInput).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing questions array", {}, "questions must be an array of 1 to 4 questions"],
    [
      "too many questions",
      {
        questions: [
          { header: "A", question: "Q?", options: validOptions, multiSelect: false },
          { header: "B", question: "Q?", options: validOptions, multiSelect: false },
          { header: "C", question: "Q?", options: validOptions, multiSelect: false },
          { header: "D", question: "Q?", options: validOptions, multiSelect: false },
          { header: "E", question: "Q?", options: validOptions, multiSelect: false },
        ],
      },
      "questions must be an array of 1 to 4 questions",
    ],
    [
      "non-boolean multiSelect",
      {
        questions: [{ header: "Stack", question: "Q?", options: validOptions, multiSelect: "no" }],
      },
      "questions[0].multiSelect must be a boolean",
    ],
    [
      "too few options",
      {
        questions: [
          {
            header: "Stack",
            question: "Q?",
            options: [{ label: "A", description: "a" }],
            multiSelect: false,
          },
        ],
      },
      "questions[0].options must be an array of 2 to 4 options",
    ],
    [
      "empty option description",
      {
        questions: [
          {
            header: "Stack",
            question: "Q?",
            options: [
              { label: "A", description: "a" },
              { label: "B", description: "" },
            ],
            multiSelect: false,
          },
        ],
      },
      "questions[0].options[1].description must not be empty",
    ],
    [
      "missing option label",
      {
        questions: [
          {
            header: "Stack",
            question: "Q?",
            options: validOptions.map((option) => ({ description: option.description })),
            multiSelect: false,
          },
        ],
      },
      "questions[0].options[0].label must be a string",
    ],
    ["non-record question", { questions: ["not a question"] }, "questions[0] must be an object"],
  ])(
    "reports the failed constraint for %s without echoing payload text",
    async (_case, malformedInput, expectedDetail) => {
      const requestUserInput = vi.fn();
      const authorizer = createClaudeCliUserInputAuthorizer(createContext(requestUserInput));

      const result = await authorizer.authorize({
        input: malformedInput as Record<string, unknown>,
        signal: new AbortController().signal,
      });

      expect(result).toEqual({
        behavior: "deny",
        message: `OpenClaw rejected malformed Claude user questions: ${expectedDetail}. Correct the invalid field and retry AskUserQuestion.`,
      });
      expect(requestUserInput).not.toHaveBeenCalled();
    },
  );
});
