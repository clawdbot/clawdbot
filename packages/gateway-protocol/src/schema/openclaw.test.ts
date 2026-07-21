import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  validateSystemAgentChatHistoryParams,
  validateSystemAgentSetupVerifyParams,
} from "../index.js";
import {
  SystemAgentChatQuestionSchema,
  SystemAgentChatHistoryResultSchema,
  SystemAgentSetupDetectResultSchema,
  SystemAgentSetupVerifyResultSchema,
} from "./openclaw.js";

describe("OpenClaw chat question protocol", () => {
  const question = {
    id: "onboarding-next-step",
    header: "Next step",
    question: "What would you like to do first?",
    options: [{ label: "Talk to my agent" }, { label: "Connect a channel" }],
  };

  it("accepts the additive exit skip action and rejects unknown actions", () => {
    expect(Value.Check(SystemAgentChatQuestionSchema, question)).toBe(true);
    expect(Value.Check(SystemAgentChatQuestionSchema, { ...question, skipAction: "exit" })).toBe(
      true,
    );
    expect(Value.Check(SystemAgentChatQuestionSchema, { ...question, skipAction: "dismiss" })).toBe(
      false,
    );
  });
});

describe("OpenClaw chat history protocol", () => {
  it("accepts the default request and bounds explicit limits", () => {
    expect(validateSystemAgentChatHistoryParams({})).toBe(true);
    expect(validateSystemAgentChatHistoryParams({ limit: 1 })).toBe(true);
    expect(validateSystemAgentChatHistoryParams({ limit: 500 })).toBe(true);
    expect(validateSystemAgentChatHistoryParams({ limit: 0 })).toBe(false);
    expect(validateSystemAgentChatHistoryParams({ limit: 501 })).toBe(false);
  });

  it("accepts ordered role, text, and timestamp turns only", () => {
    expect(
      Value.Check(SystemAgentChatHistoryResultSchema, {
        turns: [
          { role: "user", text: "status", at: 1 },
          { role: "assistant", text: "healthy", at: 2 },
        ],
      }),
    ).toBe(true);
    expect(
      Value.Check(SystemAgentChatHistoryResultSchema, {
        turns: [{ role: "tool", text: "hidden", at: 1 }],
      }),
    ).toBe(false);
  });
});

describe("OpenClaw setup detection protocol", () => {
  it("accepts additive presentation metadata and older results without installs", () => {
    const result = {
      candidates: [
        {
          kind: "provider-auto:ollama",
          label: "Ollama",
          detail: "available locally",
          modelRef: "ollama/qwen3",
          recommended: false,
          icon: "https://cdn.simpleicons.org/ollama",
          website: "https://ollama.com/download",
        },
      ],
      manualProviders: [
        {
          id: "ollama",
          label: "Ollama",
          icon: "https://cdn.simpleicons.org/ollama",
          website: "https://ollama.com/download",
        },
      ],
      authOptions: [],
      recommendedInstalls: [
        {
          id: "ollama",
          label: "Ollama",
          hint: "Run open models locally",
          website: "https://ollama.com/download",
          icon: "https://cdn.simpleicons.org/ollama",
        },
      ],
      workspace: "/tmp/work",
      setupComplete: false,
    };

    expect(Value.Check(SystemAgentSetupDetectResultSchema, result)).toBe(true);
    expect(
      Value.Check(SystemAgentSetupDetectResultSchema, {
        ...result,
        recommendedInstalls: undefined,
      }),
    ).toBe(true);
    expect(
      Value.Check(SystemAgentSetupDetectResultSchema, {
        ...result,
        recommendedInstalls: [{ ...result.recommendedInstalls[0], website: "http://example.test" }],
      }),
    ).toBe(false);
  });
});

describe("OpenClaw setup verification protocol", () => {
  it("accepts only an empty request", () => {
    expect(validateSystemAgentSetupVerifyParams({})).toBe(true);
    expect(validateSystemAgentSetupVerifyParams({ modelRef: "openai/gpt-5.5" })).toBe(false);
  });

  it("accepts the structured success and failure results", () => {
    expect(
      Value.Check(SystemAgentSetupVerifyResultSchema, {
        ok: true,
        modelRef: "openai/gpt-5.5",
        latencyMs: 25,
      }),
    ).toBe(true);
    expect(
      Value.Check(SystemAgentSetupVerifyResultSchema, {
        ok: false,
        status: "unavailable",
        error: "no configured model",
      }),
    ).toBe(true);
  });

  it("rejects mixed or incomplete results", () => {
    expect(
      Value.Check(SystemAgentSetupVerifyResultSchema, {
        ok: true,
        modelRef: "openai/gpt-5.5",
        latencyMs: 25,
        error: "stale failure",
      }),
    ).toBe(false);
    expect(
      Value.Check(SystemAgentSetupVerifyResultSchema, {
        ok: false,
        status: "ok",
        error: "contradictory result",
      }),
    ).toBe(false);
    expect(
      Value.Check(SystemAgentSetupVerifyResultSchema, {
        ok: false,
        status: "unavailable",
      }),
    ).toBe(false);
  });
});
