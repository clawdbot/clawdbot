import { describe, expect, it } from "vitest";
import type { Message } from "../../llm/types.js";
import { assertExperienceReviewDecision } from "./experience-review-decision.test-support.js";

type DecisionInput = Parameters<typeof assertExperienceReviewDecision>[0];
function abstention(): DecisionInput {
  const messages: Message[] = [
    {
      role: "toolResult",
      toolCallId: "history",
      toolName: "exec",
      content: [{ type: "text", text: "observed recovery" }],
      isError: false,
      timestamp: 0,
    },
  ];
  return {
    messages,
    startedAt: 1,
    progress: { mutationCount: 0, proposalIds: [] },
    proposals: [],
    outcome: {
      attemptedAtMs: 1,
      outcome: "nothing",
      usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 8 },
    },
    observation: {
      requests: [
        {
          toolNames: ["exec", "read", "skill_workshop"],
          outputs: messages
            .filter((message) => message.role === "toolResult")
            .map((message) =>
              message.content
                .flatMap((part) => (part.type === "text" ? [part.text] : []))
                .join("\n"),
            ),
        },
      ],
      finalText: "NO_REPLY",
      toolCalls: [],
      toolResults: [],
    },
  };
}

function proposal(): DecisionInput {
  const input = abstention();
  input.progress = { mutationCount: 1, proposalIds: ["proposal-1"] };
  input.proposals = [{ id: "proposal-1", status: "pending" }];
  input.outcome = { ...input.outcome!, outcome: "proposed", proposalId: "proposal-1" };
  input.observation.toolCalls = [
    { type: "toolCall", id: "create", name: "skill_workshop", arguments: { action: "create" } },
  ];
  input.observation.toolResults = [
    {
      role: "toolResult",
      toolCallId: "create",
      toolName: "skill_workshop",
      content: [{ type: "text", text: "Created proposal-1" }],
      isError: false,
      timestamp: 0,
    },
  ];
  return input;
}

describe("Workshop live decision acceptance", () => {
  it("requires explicit abstention with intact evidence and a fresh recorded outcome", () => {
    expect(assertExperienceReviewDecision(abstention())).toBe("abstained");
  });

  it.each(["read", "prepare_patch"])(
    "allows successful %s before explicit abstention",
    (action) => {
      const input = abstention();
      input.observation.toolCalls.push({
        type: "toolCall",
        id: "prepare",
        name: "skill_workshop",
        arguments: { action, name: "existing-skill" },
      });
      input.observation.toolResults.push({
        role: "toolResult",
        toolCallId: "prepare",
        toolName: "skill_workshop",
        content: [{ type: "text", text: "Existing skill content" }],
        isError: false,
        timestamp: 0,
      });
      expect(assertExperienceReviewDecision(input)).toBe("abstained");
    },
  );

  it.each([
    [
      "empty completion",
      (input: DecisionInput) => {
        input.observation.finalText = "";
      },
    ],
    [
      "generic completion",
      (input: DecisionInput) => {
        input.observation.finalText = "There is nothing useful to add.";
      },
    ],
    [
      "lost replay result",
      (input: DecisionInput) => {
        input.observation.requests[0]!.outputs.pop();
      },
    ],
    [
      "missing Workshop tool",
      (input: DecisionInput) => {
        input.observation.requests[0]!.toolNames = ["exec", "read"];
      },
    ],
    [
      "stale recorded outcome",
      (input: DecisionInput) => {
        input.outcome!.attemptedAtMs = 0;
      },
    ],
    [
      "missing outcome",
      (input: DecisionInput) => {
        input.outcome = undefined;
      },
    ],
    [
      "mutation attempt before abstention",
      (input: DecisionInput) => {
        input.observation.toolCalls.push({
          type: "toolCall",
          id: "read",
          name: "skill_workshop",
          arguments: { action: "create", name: "existing-skill" },
        });
        input.observation.toolResults.push({
          role: "toolResult",
          toolCallId: "read",
          toolName: "skill_workshop",
          content: [{ type: "text", text: "Existing skill content" }],
          isError: false,
          timestamp: 0,
        });
      },
    ],
    [
      "rejected tool",
      (input: DecisionInput) => {
        input.observation.toolResults.push({
          role: "toolResult",
          toolCallId: "rejected",
          toolName: "skill_workshop",
          content: [{ type: "text", text: "name required" }],
          isError: true,
          timestamp: 0,
        });
      },
    ],
  ] as const)("rejects %s even when the proposal count is zero", (_label, corrupt) => {
    const input = abstention();
    corrupt(input);
    expect(() => assertExperienceReviewDecision(input)).toThrow();
  });
  it("accepts one pending proposal backed by a matching successful tool receipt", () => {
    expect(assertExperienceReviewDecision(proposal())).toBe("proposed");
  });
  it.each([
    [
      "missing mutation call",
      (input: DecisionInput) => {
        input.observation.toolCalls = [];
      },
    ],
    [
      "missing proposal record",
      (input: DecisionInput) => {
        input.proposals = [];
      },
    ],
    [
      "wrong tool receipt",
      (input: DecisionInput) => {
        input.observation.toolResults[0]!.toolCallId = "unrelated";
      },
    ],
    [
      "extra mutation",
      (input: DecisionInput) => {
        input.progress.mutationCount = 2;
      },
    ],
  ] as const)("rejects %s even when one proposal ID is reported", (_label, corrupt) => {
    const input = proposal();
    corrupt(input);
    expect(() => assertExperienceReviewDecision(input)).toThrow();
  });
});
