// Verifies provider API family helpers gate GPT parallel tool-call payloads.
import { describe, expect, it } from "vitest";
import { testing as extraParamsTesting } from "./embedded-agent-runner/extra-params.test-support.js";

describe("provider api families", () => {
  it.each([
    "openai-completions",
    "openai-responses",
    "openai-chatgpt-responses",
    "azure-openai-responses",
  ])("classifies %s as supporting the GPT parallel_tool_calls payload patch", (api) => {
    expect(extraParamsTesting.supportsGptParallelToolCallsPayload(api)).toBe(true);
  });

  it("rejects unrelated APIs", () => {
    expect(extraParamsTesting.supportsGptParallelToolCallsPayload("anthropic-messages")).toBe(
      false,
    );
    expect(extraParamsTesting.supportsGptParallelToolCallsPayload(undefined)).toBe(false);
  });
});
