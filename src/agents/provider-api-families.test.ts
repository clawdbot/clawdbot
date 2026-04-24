import { describe, expect, it } from "vitest";
import { supportsGptParallelToolCallsPayload } from "./provider-api-families.js";

describe("provider api families", () => {
  it.each([
    "openai-completions",
    "openai-responses",
    "openai-codex-responses",
    "azure-openai-responses",
  ])("classifies %s as supporting the GPT parallel_tool_calls payload patch", (api) => {
    expect(supportsGptParallelToolCallsPayload(api)).toBe(true);
  });

  it("rejects unrelated APIs", () => {
    expect(supportsGptParallelToolCallsPayload("anthropic-messages")).toBe(false);
    expect(supportsGptParallelToolCallsPayload(undefined)).toBe(false);
  });
});
