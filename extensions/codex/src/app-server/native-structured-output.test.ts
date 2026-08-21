import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  captureCodexNativeStructuredOutput,
  isCodexNativeStructuredOutputAttempt,
} from "./native-structured-output.js";

function attempt(overrides: Partial<EmbeddedRunAttemptParams> = {}): EmbeddedRunAttemptParams {
  return {
    runId: "collector-run",
    swarmCollector: true,
    swarmOutputSchema: {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    },
    onSwarmStructuredOutputState: vi.fn(),
    ...overrides,
  } as EmbeddedRunAttemptParams;
}

describe("Codex native structured output", () => {
  it("recognizes only collector attempts with a schema and durable capture owner", () => {
    expect(isCodexNativeStructuredOutputAttempt(attempt())).toBe(true);
    expect(isCodexNativeStructuredOutputAttempt(attempt({ swarmCollector: false }))).toBe(false);
    expect(
      isCodexNativeStructuredOutputAttempt(attempt({ onSwarmStructuredOutputState: undefined })),
    ).toBe(false);
  });

  it("parses, validates, and persists the final JSON value", async () => {
    const params = attempt();

    await captureCodexNativeStructuredOutput({
      attempt: params,
      terminalAssistantText: '{"answer":"yes"}',
    });

    expect(params.onSwarmStructuredOutputState).toHaveBeenCalledWith({
      structured: { answer: "yes" },
      invalidAttempts: 0,
    });
  });

  it.each([
    ["", "Codex native collector result was missing"],
    ["not-json", "Codex native collector result was not valid JSON"],
    [
      '{"wrong":"shape"}',
      "Codex native collector result failed schema validation: answer: must have required property 'answer'; <root>: must not have additional properties: \"wrong\"",
    ],
  ])("persists a rejected state before failing closed for %j", async (text, message) => {
    const params = attempt();

    await expect(
      captureCodexNativeStructuredOutput({ attempt: params, terminalAssistantText: text }),
    ).rejects.toThrow(message);
    expect(params.onSwarmStructuredOutputState).toHaveBeenCalledWith({
      structured: undefined,
      invalidAttempts: 1,
      schemaError: message,
    });
  });
});
