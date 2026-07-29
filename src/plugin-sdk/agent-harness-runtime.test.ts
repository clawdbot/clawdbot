/**
 * Tests agent harness runtime helpers and task dispatch behavior.
 */
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  attachModelProviderRequestTransport,
  buildAgentHarnessUserInputAnswers,
  classifyAgentHarnessTerminalOutcome,
  deliverAgentHarnessUserInputPrompt,
  formatAgentHarnessUserInputPrompt,
  getModelProviderRequestTransport,
  type AgentHarnessSupportContext,
  type AgentHarnessTerminalOutcomeClassification,
} from "./agent-harness-runtime.js";
import type {
  ProviderModelRouteRuntimePolicy,
  ProviderRouteOverridePresence,
} from "./provider-model-types.js";

const { loadResearchAutocapture } = vi.hoisted(() => ({
  loadResearchAutocapture: vi.fn(),
}));

vi.mock("../skills/research/autocapture.js", () => {
  loadResearchAutocapture();
  return {
    runSkillResearchAutoCapture: vi.fn(),
  };
});

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

describe("agent harness runtime SDK facade", () => {
  beforeEach(() => {
    loadResearchAutocapture.mockClear();
  });

  it("does not load research autocapture when the SDK facade is imported", async () => {
    await import("./agent-harness-runtime.js");

    expect(loadResearchAutocapture).not.toHaveBeenCalled();
  });

  it("exposes attached model request transport metadata helpers", () => {
    const model = attachModelProviderRequestTransport(
      { id: "gpt-test", provider: "custom-openai" },
      { auth: { mode: "header", headerName: "x-api-key", value: "secret" } },
    );

    expect(getModelProviderRequestTransport(model)).toEqual({
      auth: { mode: "header", headerName: "x-api-key", value: "secret" },
    });
  });

  it("locks the request-transport support contract", () => {
    expectTypeOf<
      NonNullable<AgentHarnessSupportContext["modelProvider"]>["requestTransportOverrides"]
    >().toEqualTypeOf<ProviderRouteOverridePresence | undefined>();
    expectTypeOf<
      NonNullable<AgentHarnessSupportContext["modelProvider"]>["runtimePolicy"]
    >().toEqualTypeOf<ProviderModelRouteRuntimePolicy | undefined>();
  });
});

describe("agent harness user input helpers", () => {
  it("formats prompts and delivers through blocking replies first", async () => {
    const onBlockReply = vi.fn();

    await deliverAgentHarnessUserInputPrompt(
      { onBlockReply },
      [
        {
          id: "mode",
          header: "Mode",
          question: "Pick a mode",
          isOther: true,
          options: [{ label: "Deep", description: "Use more context" }],
        },
      ],
      { intro: "Runtime needs input:" },
    );

    expect(onBlockReply).toHaveBeenCalledWith({
      text: [
        "Runtime needs input:",
        "",
        "Mode",
        "Pick a mode",
        "1. Deep - Use more context",
        "Other: reply with your own answer.",
      ].join("\n"),
    });
  });

  it("normalizes keyed multi-question answers with option indexes", () => {
    expect(
      buildAgentHarnessUserInputAnswers(
        [
          {
            id: "repo",
            header: "Repository",
            question: "Which repo?",
            isOther: true,
          },
          {
            id: "mode",
            header: "Mode",
            question: "Which mode?",
            isOther: false,
            options: [{ label: "Fast" }, { label: "Deep" }],
          },
        ],
        "repo: openclaw\nmode: 2",
      ),
    ).toEqual({
      answers: {
        mode: { answers: ["Deep"] },
        repo: { answers: ["openclaw"] },
      },
    });
  });

  it("supports runtime-specific text formatting", () => {
    expect(
      formatAgentHarnessUserInputPrompt(
        [
          {
            id: "answer",
            header: "Header",
            question: "a < b",
          },
        ],
        { formatText: (text) => text.replaceAll("<", "&lt;") },
      ),
    ).toContain("a &lt; b");
  });

  it("preserves blank fallback lines so skipped answers stay aligned", () => {
    expect(
      buildAgentHarnessUserInputAnswers(
        [
          { id: "q1", header: "Q1", question: "First?" },
          { id: "q2", header: "Q2", question: "Second?" },
          { id: "q3", header: "Q3", question: "Third?" },
        ],
        "\nyes\nno",
      ),
    ).toEqual({
      answers: {
        q1: { answers: [] },
        q2: { answers: ["yes"] },
        q3: { answers: ["no"] },
      },
    });
  });
});
