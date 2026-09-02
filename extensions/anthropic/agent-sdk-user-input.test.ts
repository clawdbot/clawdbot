import type { CliBackendExecuteContext } from "openclaw/plugin-sdk/cli-backend";
import { describe, expect, it, vi } from "vitest";
import { createClaudeAgentSdkUserInputAuthorizer } from "./agent-sdk-user-input.js";

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

describe("Claude Agent SDK user input adapter", () => {
  it("maps Claude questions and answers while deduplicating the SDK callbacks", async () => {
    const requestUserInput = vi.fn(async () => ({
      status: "answered" as const,
      answers: {
        question_1: ["Vitest"],
        question_2: ["Unit tests", "UI proof"],
      },
    }));
    const authorizer = createClaudeAgentSdkUserInputAuthorizer(createContext(requestUserInput));
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
    const authorizer = createClaudeAgentSdkUserInputAuthorizer(
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

  it("rejects malformed questions before invoking the host", async () => {
    const requestUserInput = vi.fn();
    const authorizer = createClaudeAgentSdkUserInputAuthorizer(createContext(requestUserInput));

    await expect(
      authorizer.authorize({
        input: { questions: [{ header: "Too long for Claude", question: "Missing options" }] },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      behavior: "deny",
      message: "OpenClaw rejected malformed Claude user questions.",
    });
    expect(requestUserInput).not.toHaveBeenCalled();
  });
});
