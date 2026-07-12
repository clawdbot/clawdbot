// Tool result cap advice tests cover doctor guidance for capped tool output.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  buildToolResultCapDoctorAdvice,
  collectToolResultCapDoctorIssues,
  toolResultCapDoctorIssueToHealthFinding,
} from "./doctor-tool-result-cap-advice.js";

describe("buildToolResultCapDoctorAdvice", () => {
  it("stays quiet for unset config outside deep doctor output", () => {
    expect(
      buildToolResultCapDoctorAdvice({
        contextWindowTokens: 200_000,
        modelKey: "openai/gpt-5.5",
      }),
    ).toEqual([]);
  });

  it("shows the effective auto cap in deep doctor output", () => {
    expect(
      buildToolResultCapDoctorAdvice({
        contextWindowTokens: 200_000,
        modelKey: "openai/gpt-5.5",
        deep: true,
      }),
    ).toEqual([
      '- primary model "openai/gpt-5.5" context window 200,000 tokens; live tool-result cap 64,000 chars (auto)',
    ]);
  });

  it("warns when an explicit cap keeps a large model on the old 16K ceiling", () => {
    expect(
      buildToolResultCapDoctorAdvice({
        contextWindowTokens: 200_000,
        modelKey: "openai/gpt-5.5",
        configuredCap: 16_000,
        scopeLabel: 'agent "writer"',
      }),
    ).toEqual([
      '- agent "writer": configured toolResultMaxChars is 16,000 chars; unset it to use the 64,000 char auto cap for "openai/gpt-5.5".',
    ]);
  });

  it("warns when an explicit cap is above the runtime context-share ceiling", () => {
    expect(
      buildToolResultCapDoctorAdvice({
        contextWindowTokens: 8_000,
        modelKey: "local/tiny",
        configuredCap: 20_000,
      }),
    ).toEqual([
      "- configured toolResultMaxChars is 20,000 chars, but this model can use at most 9,600 chars per live tool result; lower it or unset it.",
    ]);
  });

  it("maps cap advice issues to structured health findings", () => {
    const [issue] = collectToolResultCapDoctorIssues({
      contextWindowTokens: 200_000,
      modelKey: "openai/gpt-5.5",
      configuredCap: 16_000,
      path: "agents.writer.contextLimits.toolResultMaxChars",
      scopeLabel: 'agent "writer"',
      target: "agents.writer",
    });

    expect(
      toolResultCapDoctorIssueToHealthFinding(expectDefined(issue, "issue test invariant")),
    ).toEqual({
      checkId: "core/doctor/tool-result-cap",
      severity: "warning",
      message:
        'agent "writer": configured toolResultMaxChars is 16,000 chars; unset it to use the 64,000 char auto cap for "openai/gpt-5.5".',
      path: "agents.writer.contextLimits.toolResultMaxChars",
      target: "agents.writer",
      requirement: "configured-below-auto-cap",
      fixHint: "Lower or unset agents.writer.contextLimits.toolResultMaxChars.",
    });
  });
});
