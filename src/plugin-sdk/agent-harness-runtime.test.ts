import { describe, expect, it } from "vitest";
import {
  classifyAgentHarnessTerminalOutcome,
  type AgentHarnessTerminalOutcomeClassification,
} from "./agent-harness-runtime.js";

describe("classifyAgentHarnessTerminalOutcome", () => {
  it("does not classify an in-flight turn", () => {
    expect(
      classifyAgentHarnessTerminalOutcome({
        assistantTexts: [],
        reasoningText: "",
        planText: "",
        promptError: null,
        turnCompleted: false,
      }),
    ).toBeUndefined();
  });

  it("does not classify prompt errors as terminal empty-output outcomes", () => {
    expect(
      classifyAgentHarnessTerminalOutcome({
        assistantTexts: [],
        reasoningText: "",
        planText: "",
        promptError: new Error("turn failed"),
        turnCompleted: true,
      }),
    ).toBeUndefined();
  });

  it("does not classify deliberate silent replies such as NO_REPLY", () => {
    expect(
      classifyAgentHarnessTerminalOutcome({
        assistantTexts: ["NO_REPLY"],
        reasoningText: "",
        planText: "",
        promptError: null,
        turnCompleted: true,
      }),
    ).toBeUndefined();
  });

  it("treats empty-string prompt errors as terminal errors", () => {
    expect(
      classifyAgentHarnessTerminalOutcome({
        assistantTexts: [],
        reasoningText: "",
        planText: "",
        promptError: "",
        turnCompleted: true,
      }),
    ).toBeUndefined();
  });

  it("treats whitespace-only assistant text as not visible", () => {
    expect(
      classifyAgentHarnessTerminalOutcome({
        assistantTexts: ["  ", "\n\t"],
        reasoningText: "",
        planText: "",
        promptError: null,
        turnCompleted: true,
      }),
    ).toBe("empty");
  });

  it("classifies a completed turn with plan text only as planning-only", () => {
    expect(
      classifyAgentHarnessTerminalOutcome({
        assistantTexts: [],
        reasoningText: "",
        planText: "1. inspect\n2. patch\n3. test",
        promptError: null,
        turnCompleted: true,
      }),
    ).toBe("planning-only");
  });

  it("prefers planning-only when both plan and reasoning text are present", () => {
    expect(
      classifyAgentHarnessTerminalOutcome({
        assistantTexts: [],
        reasoningText: "I need to inspect the files.",
        planText: "I will inspect, patch, and test.",
        promptError: null,
        turnCompleted: true,
      }),
    ).toBe("planning-only");
  });

  it("classifies a completed turn with reasoning text only as reasoning-only", () => {
    expect(
      classifyAgentHarnessTerminalOutcome({
        assistantTexts: [],
        reasoningText: "The answer depends on the current repository state.",
        planText: "",
        promptError: null,
        turnCompleted: true,
      }),
    ).toBe("reasoning-only");
  });

  it("classifies a completed turn with no visible output as empty", () => {
    expect(
      classifyAgentHarnessTerminalOutcome({
        assistantTexts: [],
        reasoningText: "  ",
        planText: "\n",
        promptError: null,
        turnCompleted: true,
      }),
    ).toBe("empty");
  });

  it("returns only terminal fallback classifications, not ok", () => {
    const classification: AgentHarnessTerminalOutcomeClassification =
      classifyAgentHarnessTerminalOutcome({
        assistantTexts: [],
        reasoningText: "",
        planText: "",
        promptError: null,
        turnCompleted: true,
      }) ?? "empty";

    expect(classification).toBe("empty");
  });
});
